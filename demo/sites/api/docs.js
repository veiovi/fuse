// Bolt API's documentation page (GET /).
import { escapeHtml as esc } from '../shared.js';

const CSS = `
:root{--side:#0d1424;--side-ink:#c8d1e3;--side-muted:#7c89a3;--bolt:#fbbf24;--bg:#fff;--ink:#0f172a;--muted:#5b6478;--line:#e5e8ef;--link:#2563eb;--code:#0b1120;--code-ink:#e2e8f0;--soft:#f6f7fb;--get:#15803d;--post:#1d4ed8;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--ink:#e6eaf2;--muted:#97a1b6;--line:#1f2a40;--link:#7aa2ff;--code:#060a14;--soft:#111a2e;--get:#4ade80;--post:#7aa2ff;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
:not(pre)>code{background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:.05rem .35rem}
.shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
aside{background:var(--side);color:var(--side-ink);padding:26px 22px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:750;font-size:1.2rem;text-decoration:none}
.brand svg{color:var(--bolt)}
.brand small{font-weight:600;font-size:.72rem;color:var(--side);background:var(--bolt);border-radius:5px;padding:.05rem .35rem}
aside h4{margin:26px 0 8px;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--side-muted)}
aside nav a{display:flex;align-items:center;gap:8px;color:var(--side-ink);text-decoration:none;padding:5px 0;font-size:.92rem}
aside nav a:hover{color:#fff}
.m{display:inline-block;min-width:38px;font:700 .66rem/1.6 ui-monospace,Menlo,monospace;text-align:center;border-radius:4px;padding:0 4px;color:#fff}
.m.get{background:var(--get)}.m.post{background:var(--post)}
.side-note{margin-top:28px;font-size:.82rem;color:var(--side-muted)}
main{padding:44px 48px 80px;max-width:900px}
h1{font-size:2.1rem;margin:0 0 .25rem;letter-spacing:-.02em}
.tag{color:var(--muted);font-size:1.1rem;margin:0 0 1.4rem}
h2{font-size:1.35rem;margin:2.6rem 0 .6rem;padding-top:.6rem;border-top:1px solid var(--line);letter-spacing:-.01em}
h3{font-size:1.05rem;margin:1.6rem 0 .4rem}
.base{display:inline-flex;gap:10px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:.35rem .7rem;font-size:.9rem}
.callout{border-left:4px solid var(--bolt);background:var(--soft);padding:12px 16px;border-radius:0 10px 10px 0;margin:1.2rem 0}
pre{background:var(--code);color:var(--code-ink);padding:14px 16px;border-radius:10px;overflow-x:auto;line-height:1.55;margin:.6rem 0 1rem}
pre .c{color:#7c89a3}pre .s{color:#a5d6a7}pre .k{color:#fbbf24}
.endpoint{border:1px solid var(--line);border-radius:14px;padding:4px 20px 8px;margin:1.2rem 0}
.endpoint h3{display:flex;align-items:center;gap:10px;font-family:ui-monospace,Menlo,monospace;font-size:1rem}
.pill{font:600 .72rem system-ui;border-radius:999px;padding:.05rem .55rem;border:1px solid currentColor;color:var(--muted)}
.pill.lock{color:#b45309}
table{width:100%;border-collapse:collapse;font-size:.92rem;margin:.4rem 0 1rem}
th,td{text-align:left;border-bottom:1px solid var(--line);padding:7px 10px;vertical-align:top}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
@media (max-width:860px){.shell{grid-template-columns:1fr}aside{position:static;height:auto}main{padding:28px 16px 60px}}
`;

const BOLT = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" fill="currentColor"/></svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0d1424"/><path d="M13 3 5 14h5.5l-1 7 8-11H12l1-7z" fill="#fbbf24"/></svg>')}`;

/** Shell-style example: `$ cmd` lines highlighted, the rest as output. */
function shell(text) {
  return `<pre>${esc(text).replace(/^(\$ .*)$/gm, '<span class="k">$1</span>').replace(/^(#.*)$/gm, '<span class="c">$1</span>')}</pre>`;
}

function code(text) {
  return `<pre>${esc(text)}</pre>`;
}

/**
 * @param {object} options
 * @param {string} options.base the API's base URL as the reader reached it
 * @param {string} options.registry registry URL clients should use
 */
export function docsPage({ base, registry }) {
  const endpoint = (method, path, locked, body) => `
<section class="endpoint" id="${method.toLowerCase()}-${path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}">
  <h3><span class="m ${method.toLowerCase()}">${method}</span>${esc(path)} <span class="pill ${locked ? 'lock' : ''}">${locked ? 'Fuse pass' : 'public'}</span></h3>
  ${body}
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bolt API · Docs</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="shell">
<aside>
  <a class="brand" href="/">${BOLT} Bolt API <small>v1</small></a>
  <h4>Guide</h4>
  <nav>
    <a href="#overview">Overview</a>
    <a href="#quickstart">Quick start</a>
    <a href="#auth">Authentication</a>
    <a href="#errors">Errors and limits</a>
  </nav>
  <h4>Endpoints</h4>
  <nav>
    <a href="#get-v1-status"><span class="m get">GET</span>/v1/status</a>
    <a href="#get-v1-search"><span class="m get">GET</span>/v1/search</a>
    <a href="#post-v1-summarize"><span class="m post">POST</span>/v1/summarize</a>
    <a href="#get-v1-me"><span class="m get">GET</span>/v1/me</a>
  </nav>
  <p class="side-note">Gateway: Fuse middleware. Moderators: <a href="/.fuse/admin" style="color:var(--bolt)">/.fuse/admin</a></p>
</aside>
<main>
  <h1 id="overview">Bolt API</h1>
  <p class="tag">Search and summarize, with no API keys and no sign-up.</p>
  <span class="base">Base URL <code>${esc(base)}</code></span>

  <div class="callout">
    Protected endpoints use <strong>Fuse</strong>. Your first request of the day answers a challenge with a
    zero-knowledge proof, which spends one slot of your credential's daily budget. After that an ordinary
    session cookie carries you. Bolt only ever learns a pseudonym that is unique to Bolt.
  </div>

  <h2 id="quickstart">Quick start</h2>
  <p>The <code>fuse</code> CLI (from <code>@fuse/agent</code>) holds a credential and answers challenges for you:</p>
  ${shell(`# one-time: back a credential with a (simulated) deposit
$ npx fuse init --tier pro

$ npx fuse fetch "${base}/v1/search?q=hello"
$ npx fuse fetch "${base}/v1/me"
$ npx fuse status            # slots left today, pseudonym per site`)}
  <p>From code, the agent SDK does the same for any request:</p>
  ${code(`import { FuseAgent } from '@fuse/agent';

const agent = await FuseAgent.create({ registry: '${registry}', tier: 'pro' });
const res = await agent.fetch('${base}/v1/summarize', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Paste a few paragraphs here. Bolt keeps the sentences that matter most.', sentences: 2 }),
});
console.log(await res.json());`)}

  <h2 id="auth">Authentication</h2>
  <p>Without a session, a protected endpoint answers <code>401</code> with a single-use challenge (valid for two minutes):</p>
  ${shell(`$ curl -i "${base}/v1/search?q=hello"
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Fuse challenge="eyJ2IjoxLC…", network="fuse-demo-v1", registry="${registry}"

{"error":"fuse-required","challenge":"eyJ2IjoxLC…","network":"fuse-demo-v1","registry":"${registry}",…}`)}
  <p>Retry the same request with a proof for that challenge, bound to the origin you connected to:</p>
  ${shell(`Authorization: Fuse origin="${base}", challenge="eyJ2IjoxLC…", token="AQAA…"

HTTP/1.1 200 OK
Fuse-Pseudonym: anon-3f2a91c0
Set-Cookie: fuse_…=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)}
  <p>Send the cookie on later requests; no further proofs are needed while the session lives.</p>

  ${endpoint('GET', '/v1/status', false, `
  <p>Liveness and the Fuse settings of this deployment. No pass needed.</p>
  ${shell(`$ curl "${base}/v1/status"
{"ok":true,"service":"Bolt API","version":"1.0.0","fuse":{"network":"fuse-demo-v1","protected":["/v1/search","/v1/summarize","/v1/me"],…}}`)}`)}

  ${endpoint('GET', '/v1/search', true, `
  <p>Keyword search over Bolt's small corpus of articles about Fuse.</p>
  <table><tr><th>Query</th><th>Rules</th><th>Meaning</th></tr>
    <tr><td><code>q</code></td><td>required, ≤ 200 chars</td><td>What to look for</td></tr>
    <tr><td><code>limit</code></td><td>optional, 1–20 (default 5)</td><td>Maximum results</td></tr></table>
  ${shell(`$ npx fuse fetch "${base}/v1/search?q=pseudonym&limit=2"
{"query":"pseudonym","results":[{"id":"pseudonyms","title":"Per-site pseudonyms","snippet":"Fuse derives a pseudonym as Poseidon(key, siteId).","score":11.1},…],"caller":"anon-3f2a91c0"}`)}`)}

  ${endpoint('POST', '/v1/summarize', true, `
  <p>Extractive summary of a text: the sentences that carry the most weight, in their original order.</p>
  <table><tr><th>JSON field</th><th>Rules</th><th>Meaning</th></tr>
    <tr><td><code>text</code></td><td>required string, ≤ 20,000 chars</td><td>Text to summarize</td></tr>
    <tr><td><code>sentences</code></td><td>optional number, 1–5 (default 2)</td><td>Sentences to keep</td></tr></table>
  <p>Send <code>Content-Type: application/json</code>; bodies are limited to 32 KB.</p>
  ${code(`→ {"summary":"…","sentences":["…","…"],"stats":{"inputSentences":9,"inputWords":180,"keptSentences":2},"caller":"anon-3f2a91c0"}`)}`)}

  ${endpoint('GET', '/v1/me', true, `
  <p>Everything Bolt knows about you: your pseudonym here and its reputation.</p>
  ${shell(`$ npx fuse fetch "${base}/v1/me"
{"pseudonym":"0x1c…a91c0","short":"anon-3f2a91c0","reputation":"probation","site":"Bolt API",…}`)}`)}

  <h2 id="errors">Errors and limits</h2>
  <p>Every request to <code>/v1/*</code> is first checked against the routes above: unknown endpoints, extra query
  parameters, wrong field types and oversized bodies are refused with <code>400</code> before any proof work.</p>
  <table>
    <tr><th>Status</th><th>error</th><th>Meaning</th></tr>
    <tr><td>400</td><td><code>request-not-in-spec</code></td><td>The request does not match a declared route (see <code>reason</code>)</td></tr>
    <tr><td>401</td><td><code>fuse-required</code></td><td>No session: answer the challenge (a <code>reason</code> says why a proof was refused)</td></tr>
    <tr><td>403</td><td><code>banned</code></td><td>A moderator banned your pseudonym here; it is the same on every visit, so the ban holds</td></tr>
    <tr><td>403</td><td><code>credential-burned</code></td><td>Your credential spent a slot twice, revealing its key</td></tr>
    <tr><td>429</td><td><code>rate-limited</code></td><td>Over your per-minute budget; see <code>Retry-After</code></td></tr>
    <tr><td>503</td><td><code>log-unavailable</code></td><td>The Fuse network could not check your proof; try again</td></tr>
  </table>
  <p>Rate limits follow reputation: a new pseudonym is on <strong>probation</strong> for 24 hours (60 requests a minute),
  then a <strong>member</strong> (600 a minute).</p>
</main>
</div>
</body>
</html>`;
}
