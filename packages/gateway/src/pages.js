// HTML the gateway serves itself: the 401 interstitial (which also carries the
// challenge for the browser extension), short notices for other refusals,
// and the moderator page. All self-contained: inline CSS, nonce'd inline JS.
import { NETWORK } from '@fuse/core';
import { escapeHtml as esc } from './http.js';

const FUSE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M13.2 2.5 5.5 13.1h5.3l-1.9 8.4 9.6-12.2h-5.6l.3-6.8z" fill="currentColor"/></svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M13.2 2.5 5.5 13.1h5.3l-1.9 8.4 9.6-12.2h-5.6l.3-6.8z" fill="#e2580b"/></svg>')}`;

const BASE_CSS = `
:root{--bg:#f5f3ee;--card:#fff;--ink:#1d1b18;--muted:#6c675e;--line:#e4e0d7;--accent:#e2580b;--accent-ink:#fff;--soft:#fbf0e6;--ok:#1f7a4d;--bad:#b42318;--code:#1f1d1a;--code-ink:#f3efe7;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#131211;--card:#1c1b19;--ink:#f1eee8;--muted:#a39d92;--line:#33302b;--accent:#ff8a3d;--accent-ink:#1a0d03;--soft:#2a1f17;--ok:#5cc78f;--bad:#ff7b6e;--code:#0c0b0a;--code-ink:#efe9de;color-scheme:dark}}
:root[data-theme=dark]{--bg:#131211;--card:#1c1b19;--ink:#f1eee8;--muted:#a39d92;--line:#33302b;--accent:#ff8a3d;--accent-ink:#1a0d03;--soft:#2a1f17;--ok:#5cc78f;--bad:#ff7b6e;--code:#0c0b0a;--code-ink:#efe9de;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
.brand{display:inline-flex;align-items:center;gap:.45rem;color:var(--accent);font-weight:650;letter-spacing:.01em;font-size:.92rem}
.brand span{color:var(--muted);font-weight:500}
`;

function page({ title, nonce, body, script = '', head = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON}">
${head}
<style>${BASE_CSS}${PAGE_CSS}</style>
</head>
<body>
${body}
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`;
}

const PAGE_CSS = `
.wrap{max-width:600px;margin:0 auto;padding:48px 16px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -18px rgba(0,0,0,.18)}
h1{font-size:1.65rem;line-height:1.2;margin:.9rem 0 .6rem;letter-spacing:-.01em}
.lede{color:var(--muted);margin:0 0 1.4rem}
.learn{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 1.2rem}
.learn h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 .6rem}
.learn ul{list-style:none;margin:0;padding:0;display:grid;gap:.45rem}
.learn li{display:grid;grid-template-columns:22px 1fr;gap:.4rem;align-items:start}
.yes{color:var(--ok);font-weight:700}.no{color:var(--bad);font-weight:700}
.pill{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:.05rem .4rem;border-radius:6px;font-size:.88em}
.cost{font-size:.95rem;margin:0 0 1.4rem}
.actions{display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;margin-bottom:.4rem}
.button{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:650;padding:.75rem 1.2rem;border-radius:10px}
.button:hover{filter:brightness(1.05)}
.status{display:flex;align-items:center;gap:.5rem;color:var(--muted);font-size:.9rem}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
.agents{margin-top:1.6rem;padding-top:1.3rem;border-top:1px solid var(--line)}
.agents h2{font-size:1rem;margin:0 0 .35rem}
.agents p{margin:.2rem 0 .7rem;color:var(--muted);font-size:.95rem}
pre{background:var(--code);color:var(--code-ink);padding:12px 14px;border-radius:10px;overflow-x:auto;margin:0 0 .6rem;white-space:pre}
details{margin-top:1.2rem;color:var(--muted);font-size:.88rem}
details pre{white-space:pre-wrap;word-break:break-all}
summary{cursor:pointer}
.alert{border:1px solid var(--bad);color:var(--bad);border-radius:10px;padding:.6rem .8rem;margin:0 0 1rem;font-size:.92rem}
.foot{text-align:center;color:var(--muted);font-size:.82rem;margin-top:18px}
@media (max-width:520px){.card{padding:22px}h1{font-size:1.4rem}}
`;

const REASONS = {
  'challenge-expired': 'the challenge had expired (they last two minutes)',
  'challenge-used': 'that challenge was already used',
  'challenge-invalid': 'the challenge was not one this site issued',
  'origin-mismatch': 'the proof was made for a different site',
  'origin-not-allowed': 'the proof was made for an origin this site does not serve',
  'origin-invalid': 'the claimed origin was not a valid URL',
  'malformed-token': 'the token was malformed',
  'wrong-epoch': "the proof was for a different day's budget",
  'bad-proof': 'the zero-knowledge proof did not verify',
  'unknown-root': 'the credential is not in any registry this site accepts (revoked, or a different registry)',
  replay: 'that proof had already been used',
};

const jsString = (value) => `'${String(value).replace(/[\\']/g, '\\$&')}'`;

/** Human description of a rejection reason. */
export function describeReason(reason) {
  return REASONS[reason] ?? String(reason ?? 'unknown reason');
}

/**
 * 401 page for browsers. Carries the challenge in <meta> tags for the
 * extension, and polls /.fuse/session so it continues by itself once the
 * extension has redeemed a proof.
 */
export function interstitialPage({ siteName, challenge, registry, installUrl, url, method, reason, nonce }) {
  const site = esc(siteName);
  const head = [
    `<meta name="fuse-challenge" content="${esc(challenge)}">`,
    `<meta name="fuse-registry" content="${esc(registry ?? '')}">`,
    `<meta name="fuse-network" content="${esc(NETWORK)}">`,
  ].join('\n');
  const body = `
<main class="wrap" data-method="${esc(method)}">
  <div class="card">
    <div class="brand">${FUSE_ICON} Fuse <span>· protected page</span></div>
    <h1>${site} asks for a Fuse pass</h1>
    <p class="lede">Fuse lets you into protected pages without an account: your device proves, with a zero-knowledge proof, that it holds a deposit-backed credential with budget left today, without revealing which credential. Each site gets its own pseudonym for you, so bans stick but nobody can follow you from site to site.</p>
    ${reason ? `<p class="alert" role="alert">Your last attempt was refused: ${esc(describeReason(reason))}. Try again.</p>` : ''}
    <section class="learn">
      <h2>What ${site} will learn</h2>
      <ul>
        <li><span class="yes">✓</span><span>A pseudonym that exists only here, like <span class="pill">anon-3f2a91c0</span>. It stays the same on this site and cannot be linked to you anywhere else.</span></li>
        <li><span class="no">✕</span><span>Your name, email, account or credential.</span></li>
        <li><span class="no">✕</span><span>Which other sites you use, or how much of your budget is left.</span></li>
      </ul>
    </section>
    <p class="cost">The first visit spends <strong>1 of your daily slots</strong>. After that an ordinary session cookie keeps you signed in.</p>
    <div class="actions">
      <a class="button" href="${esc(installUrl)}">Install the Fuse extension</a>
      <span class="status" id="status" aria-live="polite"><span class="dot"></span>Already installed? This page continues by itself.</span>
    </div>
    <section class="agents">
      <h2>Scripts and AI agents</h2>
      <p>The Fuse agent SDK answers the challenge itself:</p>
      <pre>npx fuse fetch ${esc(JSON.stringify(url))}</pre>
      <pre>import { FuseAgent } from '@fuse/agent';

const agent = await FuseAgent.create({
  registry: ${esc(jsString(registry ?? ''))},
  tier: 'pro',
});
const res = await agent.fetch(${esc(jsString(url))});</pre>
    </section>
    <details>
      <summary>Technical details</summary>
      <pre>HTTP/1.1 401 Unauthorized
WWW-Authenticate: Fuse challenge="${esc(challenge)}", network="${esc(NETWORK)}", registry="${esc(registry ?? '')}"</pre>
      <p>Single-use challenge, valid for two minutes. Answer with <code>Authorization: Fuse origin="…", challenge="…", token="…"</code> on this request, or POST it to <code>/.fuse/redeem</code>.</p>
    </details>
  </div>
  <p class="foot">${site} · Fuse network <code>${esc(NETWORK)}</code></p>
</main>`;
  const script = `
(() => {
  const status = document.getElementById('status');
  const method = document.querySelector('main').dataset.method;
  let tries = 0;
  async function check() {
    tries += 1;
    try {
      const res = await fetch('/.fuse/session', { credentials: 'same-origin', cache: 'no-store' });
      const session = await res.json();
      if (session.authenticated) {
        if (method === 'GET' || method === 'HEAD') {
          status.textContent = 'Signed in as ' + session.short + '. Loading…';
          location.reload();
        } else {
          status.textContent = 'Signed in as ' + session.short + '. Go back and submit again.';
        }
        return;
      }
    } catch {}
    if (tries < 400) setTimeout(check, 1500);
  }
  setTimeout(check, 1500);
})();`;
  return page({ title: `${siteName} · Fuse pass needed`, nonce, head, body, script });
}

/** A short refusal page (banned, rate limited, not in spec, unavailable). */
export function noticePage({ siteName, title, message, detail }) {
  const body = `
<main class="wrap">
  <div class="card">
    <div class="brand">${FUSE_ICON} Fuse <span>· ${esc(siteName)}</span></div>
    <h1>${esc(title)}</h1>
    <p class="lede">${esc(message)}</p>
    ${detail ? `<p class="cost">${esc(detail)}</p>` : ''}
    <div class="actions"><a class="button" href="/">Back to ${esc(siteName)}</a></div>
  </div>
</main>`;
  return page({ title: `${siteName} · ${title}`, body });
}

const ADMIN_CSS = `
.top{border-bottom:1px solid var(--line);background:var(--card)}
.top-inner{max-width:1240px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:18px 24px}
.top h1{margin:0;font-size:1.15rem}
.top small{color:var(--muted);font-weight:500}
.live{display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem;color:var(--muted)}
.live i{width:8px;height:8px;border-radius:50%;background:var(--muted);display:inline-block}
.live.on i{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
.admin{max-width:1240px;margin:0 auto;padding:20px 24px 48px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.stat b{display:block;font-size:1.5rem;font-variant-numeric:tabular-nums;line-height:1.2}
.stat span{color:var(--muted);font-size:.8rem}
.cols{display:grid;grid-template-columns:minmax(0,2.4fr) minmax(240px,1fr);gap:20px;align-items:start}
@media (max-width:900px){.cols{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.panel h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0;padding:12px 16px;border-bottom:1px solid var(--line)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td.seen{font-size:.82rem;line-height:1.35}
td.seen span{display:block;color:var(--muted)}
th{font-size:.75rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.who{display:inline-flex;align-items:center;gap:.5rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.swatch{width:12px;height:12px;border-radius:4px;display:inline-block}
.badge{display:inline-block;font-size:.75rem;font-weight:650;padding:.12rem .5rem;border-radius:999px;border:1px solid currentColor}
.badge.probation{color:#b7791f}.badge.member{color:var(--ok)}.badge.banned{color:var(--bad)}
.why{display:block;color:var(--muted);font-size:.78rem;max-width:180px;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;font-size:.82rem;font-weight:600;border-radius:8px;padding:.32rem .75rem;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button.ban{border-color:var(--bad);color:var(--bad)}
button:hover{filter:brightness(.97)}
.empty{padding:28px 16px;color:var(--muted);text-align:center}
.feed{list-style:none;margin:0;padding:0;max-height:620px;overflow:auto}
.feed li{padding:10px 16px;border-bottom:1px solid var(--line);font-size:.86rem;display:grid;grid-template-columns:10px 1fr;gap:10px}
.feed li i{width:8px;height:8px;border-radius:50%;margin-top:.45rem;background:var(--muted)}
.feed li.good i{background:var(--ok)}.feed li.bad i{background:var(--bad)}.feed li.note i{background:var(--accent)}
.feed time{display:block;color:var(--muted);font-size:.75rem}
`;

/** Moderator view: pseudonyms, reputation, ban/unban, live activity. */
export function adminPage({ siteName, nonce }) {
  const body = `
<header class="top"><div class="top-inner">
  <div>
    <div class="brand">${FUSE_ICON} Fuse gateway</div>
    <h1>${esc(siteName)} <small>· moderation</small></h1>
  </div>
  <span class="live" id="live"><i></i><span>connecting…</span></span>
</div></header>
<main class="admin">
  <section class="stats" id="stats"></section>
  <div class="cols">
    <section class="panel">
      <h2>Pseudonyms seen at this site</h2>
      <div class="scroll"><table>
        <thead><tr><th>Pseudonym</th><th>Standing</th><th>Seen</th><th class="num">First contacts</th><th class="num">Requests</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <div class="empty" id="empty" hidden>No one has made a first contact yet.</div>
    </section>
    <section class="panel">
      <h2>Live activity</h2>
      <ul class="feed" id="feed"></ul>
    </section>
  </div>
  <p class="foot">This page is all ${esc(siteName)} knows: pseudonyms, never identities. Demo gateway: no moderator authentication.</p>
</main>`;
  const script = `
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
  };
  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const colour = (hex) => 'hsl(' + (parseInt(hex.slice(-6), 16) % 360) + ' 65% 52%)';

  async function ban(p, banned) {
    let reason;
    if (banned) {
      reason = prompt('Ban ' + p.short + '? Reason (shown to them):', 'spam');
      if (reason === null) return;
    }
    await fetch('/.fuse/admin/ban', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pseudonym: p.pseudonym, banned, reason: reason || undefined }),
    });
    refresh();
  }

  function renderRows(list) {
    const rows = $('rows');
    rows.replaceChildren();
    $('empty').hidden = list.length > 0;
    for (const p of list) {
      const who = el('span', { className: 'who', title: p.pseudonym },
        el('span', { className: 'swatch', style: 'background:' + colour(p.pseudonym) }), p.short);
      const rep = el('td');
      rep.append(el('span', { className: 'badge ' + (p.banned ? 'banned' : p.reputation), textContent: p.banned ? 'banned' : p.reputation }));
      if (p.banned && p.bannedReason) rep.append(el('span', { className: 'why', textContent: p.bannedReason, title: p.bannedReason }));
      const action = el('button', { className: p.banned ? '' : 'ban', textContent: p.banned ? 'Unban' : 'Ban' });
      action.onclick = () => ban(p, !p.banned);
      rows.append(el('tr', {},
        el('td', {}, who), rep,
        el('td', { className: 'seen', title: 'first ' + (p.firstSeen || 'never') + '\\nlast ' + (p.lastSeen || 'never') },
          'last ' + ago(p.lastSeen), el('span', { textContent: 'first ' + ago(p.firstSeen) })),
        el('td', { className: 'num', textContent: p.firstContacts }),
        el('td', { className: 'num', textContent: p.requests }),
        el('td', {}, action)));
    }
  }

  function renderStats(stats) {
    const items = [
      ['Pseudonyms', stats.pseudonyms], ['Live sessions', stats.sessions], ['First contacts', stats.proofsAccepted],
      ['Proofs rejected', stats.proofsRejected], ['Banned', stats.banned], ['Revocations applied', stats.revocationsApplied],
    ];
    if (stats.cacheHits !== undefined) items.push(['Cache hits', stats.cacheHits]);
    $('stats').replaceChildren(...items.map(([label, value]) => el('div', { className: 'stat' }, el('b', { textContent: value ?? 0 }), el('span', { textContent: label }))));
  }

  const describe = {
    'challenge-issued': (e) => ['note', 'Challenge issued' + (e.path ? ' for ' + e.method + ' ' + e.path : '')],
    'proof-accepted': (e) => ['good', e.short + ' made a first contact' + (e.path ? ' (' + e.method + ' ' + e.path + ')' : '')],
    'proof-rejected': (e) => ['bad', 'Proof rejected: ' + e.reason],
    'spec-rejected': (e) => ['bad', 'Spec gate refused ' + e.method + ' ' + e.path + ': ' + e.reason],
    'banned-request': (e) => ['bad', 'Blocked ' + e.short + ' (banned)'],
    'rate-limited': (e) => ['bad', e.short + ' hit the rate limit'],
    'pseudonym-banned': (e) => ['bad', e.short + ' banned: ' + e.reason],
    'pseudonym-unbanned': (e) => ['good', e.short + ' unbanned'],
    'revocation-applied': (e) => ['bad', 'Burned credential: banned ' + e.short + (e.sessionsEnded ? ', ended ' + e.sessionsEnded + ' session(s)' : '')],
  };

  function addEvent(e, prepend = true) {
    const fn = describe[e.type];
    if (!fn) return;
    const [kind, text] = fn(e);
    const item = el('li', { className: kind }, el('i'), el('div', {}, el('span', { textContent: text }), el('time', { textContent: new Date(e.at).toLocaleTimeString(), dateTime: e.at })));
    const feed = $('feed');
    if (prepend) feed.prepend(item); else feed.append(item);
    while (feed.children.length > 120) feed.lastChild.remove();
  }

  async function refresh() {
    try {
      const [list, info] = await Promise.all([
        fetch('/.fuse/admin/pseudonyms', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/.fuse/info', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      renderRows(list.pseudonyms);
      renderStats(info.stats);
    } catch {}
  }

  let pending = null;
  const soon = () => { clearTimeout(pending); pending = setTimeout(refresh, 250); };
  const stream = new EventSource('/.fuse/events');
  stream.onopen = () => { $('live').className = 'live on'; $('live').lastChild.textContent = 'live'; };
  stream.onerror = () => { $('live').className = 'live'; $('live').lastChild.textContent = 'reconnecting…'; };
  stream.addEventListener('hello', (msg) => {
    const hello = JSON.parse(msg.data);
    $('feed').replaceChildren();
    for (const e of (hello.recent || []).slice().reverse()) addEvent(e, false);
    soon();
  });
  for (const type of Object.keys(describe)) {
    stream.addEventListener(type, (msg) => { addEvent(JSON.parse(msg.data)); if (type !== 'challenge-issued') soon(); });
  }
  refresh();
  setInterval(refresh, 30000);
})();`;
  return page({ title: `${siteName} · Fuse moderation`, nonce, body, script, head: `<style>${ADMIN_CSS}</style>` });
}
