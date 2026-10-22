// Popup: credential status, per-site pseudonyms and permissions, the spend
// log, getting and deleting a credential. All state lives in the background;
// this page renders `status` and re-renders when storage changes.
import { glyph, h, meter } from './dom.js';
import { capitalize, clockTime, displayHost, duration, eventTime, seconds, shortHex } from './format.js';

const app = document.getElementById('app');

const ui = {
  status: null,
  tab: 'sites',
  confirmDelete: false,
  busy: false,
  error: null,
  setup: { registry: null, info: null, tier: null, loading: false, error: null },
};

async function background(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...fields });
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? 'Fuse is not responding.'), response?.error ?? {});
  return response.data;
}

async function refresh() {
  try {
    ui.status = await background('status');
    ui.error = null;
  } catch (err) {
    ui.error = err.message;
  }
  render();
}

let refreshTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 80);
});
// Keep the reset countdown honest while the popup stays open.
setInterval(() => {
  if (ui.status?.credential && !ui.confirmDelete) render();
}, 30_000);

// -- actions -----------------------------------------------------------------

async function loadTiers(registry = ui.setup.registry) {
  const setup = ui.setup;
  setup.registry = registry.trim();
  setup.loading = true;
  setup.error = null;
  render();
  try {
    setup.info = await background('registry-info', { registry: setup.registry });
    setup.registry = setup.info.registry;
    if (!setup.info.tiers.some((t) => t.id === setup.tier)) setup.tier = setup.info.tiers[0]?.id ?? null;
  } catch (err) {
    setup.info = null;
    setup.error = err.message;
  } finally {
    setup.loading = false;
    render();
  }
}

async function register() {
  const setup = ui.setup;
  ui.busy = true;
  setup.error = null;
  render();
  try {
    ui.status = await background('register', { registry: setup.registry, tier: setup.tier });
    ui.tab = 'sites';
  } catch (err) {
    setup.error = err.message;
  } finally {
    ui.busy = false;
    render();
  }
}

async function setPermission(origin, permission) {
  try {
    ui.status = await background('set-permission', { origin, permission });
  } catch (err) {
    ui.error = err.message;
  }
  render();
}

async function deleteCredential() {
  ui.busy = true;
  render();
  try {
    ui.status = await background('delete-credential');
    ui.confirmDelete = false;
    ui.setup = { registry: null, info: null, tier: null, loading: false, error: null };
  } catch (err) {
    ui.error = err.message;
  } finally {
    ui.busy = false;
    render();
  }
}

// -- views -------------------------------------------------------------------

function header(status) {
  return h(
    'header',
    { class: 'top' },
    glyph(30),
    h('div', {}, h('div', { class: 'brand' }, 'Fuse'), h('div', { class: 'tagline' }, 'A daily budget, not an identity')),
    h('span', { class: 'pill', title: 'Fuse network' }, status.network),
  );
}

function credentialSection(status) {
  const c = status.credential;
  const active = c.status === 'active';
  const pill = active
    ? h('span', { class: 'pill ok' }, 'Active')
    : h('span', { class: 'pill bad' }, c.status === 'burned' ? 'Burned' : 'Not recognized');
  const deposit = c.deposit?.amount !== undefined ? ` · ${c.deposit.amount} ${c.deposit.currency ?? ''} locked`.trimEnd() : '';
  return h(
    'section',
    { class: 'section', dataset: { role: 'credential' } },
    h('div', { class: 'eyebrow' }, 'Credential'),
    h('div', { class: 'cred-head' }, h('span', { class: 'cred-title' }, `${capitalize(c.tier)} tier`), pill),
    h('div', { class: 'meta', title: `Registry ${c.registry}, leaf #${c.index}` }, `Registry ${displayHost(c.registry)}${deposit}`),
    active ? budgetBlock(status.budget) : revokedBlock(c),
  );
}

function budgetBlock(budget) {
  return h(
    'div',
    { class: 'budget', dataset: { role: 'budget' } },
    h(
      'div',
      { class: 'budget-line' },
      h('span', { class: 'budget-num', dataset: { role: 'remaining' } }, String(budget.remaining)),
      h('span', { class: 'budget-of' }, `of ${budget.limit} slots left today`),
    ),
    meter(budget),
    h('div', { class: 'meta' }, `Resets at ${clockTime(budget.resetsAt)} · in ${duration(Date.parse(budget.resetsAt) - Date.now())}`),
  );
}

function revokedBlock(c) {
  const text =
    c.status === 'burned'
      ? 'This credential was revoked: one of its slots was used twice, which revealed its key. Delete it and get a new one.'
      : 'The registry no longer lists this credential (withdrawn, or the registry was reset). Delete it and get a new one.';
  return h('div', { class: 'alert bad' }, text);
}

function tabButton(id, label, count) {
  return h(
    'button',
    {
      class: 'tab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(ui.tab === id),
      dataset: { tab: id },
      onclick: () => {
        ui.tab = id;
        render();
      },
    },
    label,
    h('span', { class: 'count' }, String(count)),
  );
}

function permissionSelect(site) {
  const select = h(
    'select',
    {
      'aria-label': `Fuse permission for ${displayHost(site.origin)}`,
      onchange: (event) => setPermission(site.origin, event.target.value),
    },
    h('option', { value: 'ask' }, 'Ask'),
    h('option', { value: 'always' }, 'Always allow'),
    h('option', { value: 'never' }, 'Never'),
  );
  select.value = site.permission;
  return select;
}

function sitesPanel(status) {
  if (status.sites.length === 0) {
    return h('p', { class: 'empty' }, 'No sites yet. When a site asks for a Fuse proof, it appears here with the pseudonym it knows you by.');
  }
  return h(
    'ul',
    { class: 'list', dataset: { role: 'sites' } },
    status.sites.map((site) =>
      h(
        'li',
        { class: 'site', dataset: { origin: site.origin } },
        h(
          'div',
          { class: 'site-main' },
          h('div', { class: 'host', title: site.origin }, displayHost(site.origin)),
          h(
            'div',
            { class: 'meta' },
            site.short ? h('span', { class: 'mono', title: 'Your pseudonym on this site' }, site.short) : null,
            site.firstContact ? ` · first contact ${eventTime(site.firstContact)}` : ' · not contacted',
            site.bannedAt ? ' · ' : null,
            site.bannedAt ? h('span', { class: 'pill bad' }, 'banned') : null,
          ),
        ),
        permissionSelect(site),
      ),
    ),
  );
}

const OUTCOMES = {
  accepted: ['accepted', 'ok'],
  proved: ['not confirmed', ''],
  banned: ['banned', 'bad'],
  'credential-burned': ['burned', 'bad'],
  'site-unreachable': ['not delivered', 'bad'],
};

function outcomeBadge(outcome) {
  const [label, kind] = OUTCOMES[outcome] ?? ['rejected', 'bad'];
  return h('span', { class: `outcome ${kind}`, title: outcome }, label);
}

function logPanel(status) {
  const note = h(
    'p',
    { class: 'panel-note' },
    'Every slot this browser has spent. A spend you don’t recognize means something else is using your credential.',
  );
  if (status.history.length === 0) return [note, h('p', { class: 'empty' }, 'No slots spent yet.')];
  return [
    note,
    h(
      'ul',
      { class: 'list', dataset: { role: 'history' } },
      status.history.map((entry) =>
        h(
          'li',
          { class: 'spend', dataset: { spend: entry.id } },
          h(
            'div',
            { class: 'spend-top' },
            h('span', { class: 'time' }, eventTime(entry.at, { seconds: true })),
            h('span', { class: 'host', title: entry.origin }, displayHost(entry.origin)),
            outcomeBadge(entry.outcome),
          ),
          h(
            'div',
            { class: 'meta' },
            `slot ${entry.slot + 1} · proved in ${seconds(entry.provingMs)} · `,
            h('span', { class: 'mono', title: `Slot tag (nullifier) in the shared log: ${entry.nullifier}` }, `tag ${shortHex(entry.nullifier)}`),
          ),
        ),
      ),
    ),
  ];
}

function footer() {
  if (ui.confirmDelete) {
    return h(
      'footer',
      { class: 'foot' },
      h(
        'div',
        { class: 'confirm', role: 'alertdialog', 'aria-label': 'Delete credential' },
        h(
          'p',
          {},
          h('b', {}, 'Delete this credential? '),
          'Its secret key is erased from this browser and cannot be recovered. The deposit stays locked at the registry.',
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => ((ui.confirmDelete = false), render()) }, 'Cancel'),
          h(
            'button',
            { class: 'btn danger', type: 'button', disabled: ui.busy, dataset: { action: 'confirm-delete' }, onclick: deleteCredential },
            'Delete credential',
          ),
        ),
      ),
    );
  }
  return h(
    'footer',
    { class: 'foot' },
    h(
      'button',
      { class: 'link danger', type: 'button', dataset: { action: 'delete' }, onclick: () => ((ui.confirmDelete = true), render()) },
      'Delete credential…',
    ),
  );
}

function dashboard(status) {
  return [
    credentialSection(status),
    h('nav', { class: 'tabs', role: 'tablist' }, tabButton('sites', 'Sites', status.sites.length), tabButton('log', 'Spend log', status.history.length)),
    h('div', { role: 'tabpanel' }, ui.tab === 'sites' ? sitesPanel(status) : logPanel(status)),
    footer(),
  ];
}

function onboarding(status) {
  const setup = ui.setup;
  if (setup.registry === null) {
    setup.registry = status.defaultRegistry;
    queueMicrotask(() => loadTiers());
  }
  const info = setup.info;
  const incompatible = info && !info.compatible;
  const tiers = info
    ? h(
        'fieldset',
        { class: 'tiers' },
        h('legend', {}, 'Tier'),
        info.tiers.map((tier) =>
          h(
            'label',
            { class: 'tier' },
            h('input', {
              type: 'radio',
              name: 'tier',
              value: tier.id,
              checked: setup.tier === tier.id,
              onchange: () => ((setup.tier = tier.id), render()),
            }),
            h(
              'span',
              { class: 'tier-body' },
              h(
                'span',
                { class: 'tier-text' },
                h('span', { class: 'tier-name' }, capitalize(tier.id)),
                h('span', { class: 'tier-deposit' }, `Deposit ${tier.deposit} ${info.currency}`),
              ),
              h('span', { class: 'tier-slots' }, `${tier.limit} slots/day`),
            ),
          ),
        ),
      )
    : null;
  const registryInput = h('input', {
    id: 'registry-url',
    type: 'url',
    value: setup.registry,
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: (event) => (setup.registry = event.target.value),
    onkeydown: (event) => event.key === 'Enter' && loadTiers(event.target.value),
  });
  return [
    h(
      'section',
      { class: 'section onboard', dataset: { role: 'setup' } },
      h('h1', {}, 'Get a credential'),
      h(
        'p',
        {},
        'Sites ask Fuse for proof of budget instead of an account. A one-time deposit at a registry backs a credential with a number of first-contact slots per day, good on any site that speaks Fuse.',
      ),
      h('label', { class: 'field', for: 'registry-url' }, 'Registry'),
      h(
        'div',
        { class: 'field-row' },
        registryInput,
        h(
          'button',
          { class: 'btn secondary', type: 'button', disabled: setup.loading, dataset: { action: 'load-tiers' }, onclick: () => loadTiers(registryInput.value) },
          setup.loading ? 'Loading…' : 'Load',
        ),
      ),
      tiers,
      incompatible
        ? h('div', { class: 'alert' }, `This registry is on network “${info.network}”; this extension speaks “${status.network}”.`)
        : null,
      setup.error ? h('div', { class: 'alert bad', role: 'alert' }, setup.error) : null,
      h(
        'button',
        {
          class: 'btn primary wide',
          type: 'button',
          disabled: ui.busy || !info || !setup.tier || incompatible,
          dataset: { action: 'register' },
          onclick: register,
        },
        ui.busy ? 'Locking deposit…' : 'Lock deposit and create credential',
      ),
      h(
        'p',
        { class: 'fine' },
        'Your secret key is generated in this browser and never leaves it; the registry stores only a commitment to it. Demo deposits are simulated credits: no money moves.',
      ),
    ),
  ];
}

function render() {
  const status = ui.status;
  if (!status) {
    app.replaceChildren(h('p', { class: ui.error ? 'alert bad' : 'loading' }, ui.error ?? 'Loading…'));
    return;
  }
  const parts = [
    header(status),
    ui.error ? h('div', { class: 'alert bad', role: 'alert' }, ui.error) : null,
    ...(status.credential ? dashboard(status) : onboarding(status)),
  ];
  app.replaceChildren(...parts.filter(Boolean));
}

refresh();
