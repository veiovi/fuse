// GET /install: how to hold a Fuse credential, with the browser extension or
// the agent SDK. Rendered on the server so the commands carry this demo's
// real URLs and the extension's absolute path.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const extensionDist = fileURLToPath(new URL('../../extension/dist', import.meta.url));
const DEFAULT_REGISTRY = 'http://localhost:4701';

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderInstallPage({ sites = [], links = {} }) {
  const forum = sites.find((s) => s.id === 'forum') ?? sites[0];
  const api = sites.find((s) => s.id === 'api') ?? sites.find((s) => s !== forum);
  const apiUrl = api?.publicUrl ?? 'http://localhost:4720';
  const built = existsSync(`${extensionDist}/manifest.json`);
  // The CLI defaults to the demo registry's usual address; name it otherwise.
  const registryFlag = links.registry && links.registry !== DEFAULT_REGISTRY ? ` --registry ${links.registry}` : '';
  const commands = [
    { cmd: `npx fuse init --tier pro${registryFlag}`, note: 'Locks a demo deposit at the registry and saves the credential on this machine.' },
    { cmd: `npx fuse fetch ${apiUrl}/v1/search?q=hello`, note: `Answers ${api?.name ?? 'the API'}’s challenge with a proof. The first request spends one slot; the session cookie covers the rest.` },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Install Fuse</title>
<meta name="description" content="Hold a Fuse credential with the Chrome extension or the agent SDK.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<script type="module" src="/install.js"></script>
</head>
<body class="install-page">
<header class="install-head">
  <a class="wordmark wordmark--small" href="/">Fuse</a>
  <a class="install-back" href="/">Back to the network</a>
</header>
<main class="install">
  <h1 class="install-title">Hold a credential</h1>
  <p class="install-lede">People use the browser extension; scripts and agents use the SDK. Either way the key never leaves your machine: sites only ever see a proof, one point on a line, and a pseudonym of their own.</p>

  <section class="install-section" aria-labelledby="ext">
    <h2 id="ext">Chrome extension</h2>
    <ol class="install-steps">
      <li><span>Build it from the repository root.</span>${copyable('npm run build:extension')}</li>
      <li><span>Open <code>chrome://extensions</code> and turn on Developer mode.</span></li>
      <li><span>Choose Load unpacked and pick the <code>packages/extension/dist</code> folder.</span>${copyable(extensionDist)}
        <p class="install-note">${built ? 'The extension is built and ready to load.' : 'Not built yet: run the build command first.'}</p></li>
      ${forum ? `<li><span>Open <a href="${esc(forum.publicUrl)}">${esc(forum.name)}</a> and post something. The extension answers the challenge for you.</span></li>` : ''}
    </ol>
  </section>

  <section class="install-section" aria-labelledby="sdk">
    <h2 id="sdk">Agent SDK</h2>
    <ol class="install-steps">
      ${commands.map(({ cmd, note }) => `<li><span>${esc(note)}</span>${copyable(cmd)}</li>`).join('\n      ')}
    </ol>
    <p class="install-note">Registry: <a href="${esc(links.registry ?? '')}/info">${esc(links.registry ?? '')}</a></p>
  </section>
</main>
</body>
</html>`;
}

function copyable(text) {
  // Flags stay whole when a narrow screen wraps the command; paths and URLs may break.
  const shown = text
    .split(' ')
    .map((token) => (/^--?[\w-]+$/.test(token) ? `<span class="flag">${esc(token)}</span>` : esc(token)))
    .join(' ');
  return `<div class="copy"><code>${shown}</code><button type="button" class="copy-button" data-copy="${esc(text)}">Copy</button></div>`;
}
