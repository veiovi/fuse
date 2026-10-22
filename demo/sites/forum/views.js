// Acme Forum's pages. Server-rendered HTML with one small script that asks
// the gateway (GET /.fuse/session) whether this browser has a session, so
// public pages stay identical for everyone and can be cached.
import { escapeHtml as esc, timeAgo } from '../shared.js';

const ACORN = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M6 13c0-5 4.5-8 10-8s10 3 10 8H6z" fill="currentColor"/><path d="M8 14h16c0 7-3.6 12-8 13-4.4-1-8-6-8-13z" fill="currentColor" opacity=".55"/><path d="M16 2v4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(ACORN.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replaceAll('currentColor', '#c2502a'))}`;

const CSS = `
:root{--bg:#fbf6ee;--paper:#fffdf9;--ink:#2e2620;--muted:#7d6e5f;--line:#ecdfcc;--accent:#c2502a;--accent-ink:#fff;--soft:#f8e7dc;--leaf:#5d7a37;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1b1713;--paper:#231e19;--ink:#f3eadf;--muted:#b5a592;--line:#3a3129;--accent:#ee7d50;--accent-ink:#221208;--soft:#3a261c;--leaf:#9dbb72;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
h1,h2,.logo{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
.bar{max-width:860px;margin:0 auto;padding:14px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 22px}
.masthead{border-bottom:1px solid var(--line);background:var(--paper)}
.logo{display:inline-flex;align-items:center;gap:8px;font-size:1.35rem;font-weight:700;color:var(--accent);text-decoration:none}
nav{display:flex;gap:16px;flex:1}
nav a{color:var(--ink);text-decoration:none;font-weight:550;font-size:.95rem;white-space:nowrap}
nav a:hover,nav a.on{color:var(--accent)}
.who{font-size:.85rem;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:.2rem .7rem;background:var(--bg)}
.who.in{color:var(--leaf);border-color:currentColor}
main{max-width:860px;margin:0 auto;padding:28px 16px 64px}
.hero{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:26px 28px;margin-bottom:26px}
.hero h1{margin:0 0 .3rem;font-size:2rem}
.hero p{margin:0 0 1rem;color:var(--muted);max-width:60ch}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);border:0;border-radius:10px;padding:.6rem 1.1rem;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.threads{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.threads a{display:block;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:16px 20px;color:inherit;text-decoration:none}
.threads a:hover{border-color:var(--accent)}
.threads h2{margin:0 0 .2rem;font-size:1.25rem;line-height:1.3}
.excerpt{margin:0 0 .5rem;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{margin:0;font-size:.85rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.35rem .8rem;align-items:center}
.chip{display:inline-flex;align-items:center;gap:.4rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;color:var(--ink)}
.chip i{width:.8em;height:.8em;border-radius:3px;background:hsl(var(--hue) 55% 55%);display:inline-block}
.crumbs{margin-bottom:12px;font-size:.92rem}
.crumbs a{text-decoration:none}
.thread-title{font-size:1.9rem;line-height:1.25;margin:0 0 18px}
.posts{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.post{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:16px 20px}
.post header{display:flex;justify-content:space-between;gap:10px;margin-bottom:.4rem;font-size:.88rem;color:var(--muted)}
.post .body p{margin:.4rem 0}
.post:target{border-color:var(--accent);box-shadow:0 0 0 3px var(--soft)}
.reply{margin-top:22px;background:var(--soft);border-radius:14px;padding:18px 20px}
.reply p{margin:0 0 .8rem}
.member-only{display:none}
.signed-in .member-only{display:block}
.signed-in .guest-only{display:none}
form label{display:block;font-weight:600;margin:0 0 .9rem}
input[type=text],textarea{display:block;width:100%;margin-top:.35rem;font:inherit;font-weight:400;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:.6rem .75rem}
textarea{min-height:9rem;resize:vertical}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.as{color:var(--muted)}
.error{border:1px solid var(--accent);color:var(--accent);border-radius:10px;padding:.5rem .8rem}
.facts{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:14px 22px;background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin:0 0 22px}
.facts dt{font-weight:650}
.facts dd{margin:0;min-width:0}
.hex{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;word-break:break-all}
.hint{display:block;color:var(--muted);font-size:.88rem;margin-top:.2rem}
.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 .55rem;font-size:.85rem;font-weight:650}
.badge.probation{color:#b7791f}.badge.member{color:var(--leaf)}
.unknown{border:1px dashed var(--line);border-radius:16px;padding:16px 22px;margin-bottom:22px}
.unknown h2{margin:.2rem 0 .4rem;font-size:1.15rem}
.unknown ul{margin:0;padding-left:1.2rem;color:var(--muted)}
.mine{margin:.4rem 0 0;padding-left:1.1rem}
footer{max-width:860px;margin:0 auto;padding:0 16px 40px;color:var(--muted);font-size:.85rem}
@media (max-width:560px){.facts{grid-template-columns:1fr;gap:4px}.facts dd{margin-bottom:12px}.hero{padding:20px}.thread-title{font-size:1.5rem}}
`;

const SESSION_SCRIPT = `
fetch('/.fuse/session', { cache: 'no-store' }).then((r) => r.json()).then((s) => {
  if (!s.authenticated) return;
  const who = document.getElementById('who');
  who.textContent = 'Posting as ' + s.short + ' · ' + s.reputation;
  who.classList.add('in');
  document.body.classList.add('signed-in');
}).catch(() => {});`;

/** Author chip: a colour swatch derived from the pseudonym, then its short form. */
export function chip(short) {
  // Same colour as the gateway's moderator page: last 6 hex digits mod 360.
  const tail = String(short).slice(-6);
  const hue = /^[0-9a-f]{6}$/i.test(tail) ? parseInt(tail, 16) % 360 : 30;
  return `<span class="chip" style="--hue:${hue}"><i></i>${esc(short)}</span>`;
}

function paragraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function layout({ title, active = '', body }) {
  const link = (href, label) => `<a href="${href}"${active === href ? ' class="on"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<header class="masthead"><div class="bar">
  <a class="logo" href="/">${ACORN} Acme Forum</a>
  <nav>${link('/', 'Threads')}${link('/new', 'New post')}${link('/me', 'Me')}</nav>
  <span class="who" id="who">Reading as a guest</span>
</div></header>
<main>${body}</main>
<footer>Acme Forum sits behind a Fuse gateway: reading is free, and the first post of the day costs one slot of your Fuse budget. Moderators: <a href="/.fuse/admin">/.fuse/admin</a>.</footer>
<script>${SESSION_SCRIPT}</script>
</body>
</html>`;
}

export function homePage({ threads, now }) {
  const items = threads
    .map((thread) => {
      const first = thread.posts[0];
      const last = thread.posts.at(-1);
      const replies = thread.posts.length - 1;
      return `<li><a href="/t/${thread.id}">
  <h2>${esc(thread.title)}</h2>
  <p class="excerpt">${esc(first.body)}</p>
  <p class="meta">${chip(first.author)}<span>${replies} ${replies === 1 ? 'reply' : 'replies'}</span><span>active ${timeAgo(last.createdAt, now)}</span></p>
</a></li>`;
    })
    .join('\n');
  return layout({
    title: 'Acme Forum',
    active: '/',
    body: `
<section class="hero">
  <h1>Acme Forum</h1>
  <p>A small neighbourhood forum. Reading is free for everyone. Posting asks for a <strong>Fuse pass</strong>: no account and no email, and Acme only ever sees a pseudonym that exists nowhere else.</p>
  <a class="btn" href="/new">Start a thread</a>
</section>
<ul class="threads">${items}</ul>`,
  });
}

export function threadPage({ thread, now }) {
  const posts = thread.posts
    .map(
      (post) => `<li class="post" id="p${post.id}">
  <header>${chip(post.author)}<time datetime="${esc(post.createdAt)}">${timeAgo(post.createdAt, now)}</time></header>
  <div class="body">${paragraphs(post.body)}</div>
</li>`,
    )
    .join('\n');
  return layout({
    title: `${thread.title} · Acme Forum`,
    body: `
<nav class="crumbs"><a href="/">← All threads</a></nav>
<h1 class="thread-title">${esc(thread.title)}</h1>
<ol class="posts">${posts}</ol>
<section class="reply">
  <div class="guest-only">
    <p>Replying needs a Fuse pass. The first time today it costs one slot of your budget; after that your session takes over.</p>
    <a class="btn" href="/new?thread=${thread.id}">Write a reply</a>
  </div>
  <form class="member-only" method="post" action="/posts">
    <input type="hidden" name="thread" value="${thread.id}">
    <label>Your reply<textarea name="body" required maxlength="5000"></textarea></label>
    <button class="btn" type="submit">Post reply</button>
  </form>
</section>`,
  });
}

export function composePage({ short, thread, error, values = {} }) {
  const heading = thread ? `Reply to “${esc(thread.title)}”` : 'Start a thread';
  return layout({
    title: `${thread ? 'Reply' : 'New thread'} · Acme Forum`,
    active: '/new',
    body: `
<nav class="crumbs"><a href="${thread ? `/t/${thread.id}` : '/'}">← Back</a></nav>
<h1 class="thread-title">${heading}</h1>
<p class="as">You are posting as ${chip(short)}, the only name Acme knows you by.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/posts">
  ${thread ? `<input type="hidden" name="thread" value="${thread.id}">` : `<label>Title<input type="text" name="title" required maxlength="120" value="${esc(values.title ?? '')}"></label>`}
  <label>${thread ? 'Your reply' : 'What is on your mind?'}<textarea name="body" required maxlength="5000">${esc(values.body ?? '')}</textarea></label>
  <button class="btn" type="submit">${thread ? 'Post reply' : 'Post thread'}</button>
</form>`,
  });
}

export function mePage({ pseudonym, short, reputation, member, posts, now }) {
  const list = posts.length
    ? `<ul class="mine">${posts.map(({ thread, post }) => `<li><a href="/t/${thread.id}#p${post.id}">${esc(thread.title)}</a> · ${timeAgo(post.createdAt, now)}</li>`).join('')}</ul>`
    : '<span class="hint">Nothing yet.</span>';
  return layout({
    title: 'Me · Acme Forum',
    active: '/me',
    body: `
<h1 class="thread-title">This is everything Acme knows about you</h1>
<dl class="facts">
  <dt>Pseudonym</dt>
  <dd><span class="hex">${esc(pseudonym)}</span><span class="hint">Poseidon(your key, this site). Every other site gets an unrelated number, so nobody can follow you between them.</span></dd>
  <dt>Display name</dt>
  <dd>${chip(short)}</dd>
  <dt>Reputation</dt>
  <dd><span class="badge ${esc(reputation)}">${esc(reputation)}</span><span class="hint">New pseudonyms are on probation for their first 24 hours (60 requests a minute), then members (600).</span></dd>
  <dt>First seen</dt>
  <dd>${member ? `<time datetime="${esc(member.firstSeen)}">${new Date(member.firstSeen).toUTCString()}</time><span class="hint">${timeAgo(member.firstSeen, now)}</span>` : 'just now'}</dd>
  <dt>Posts</dt>
  <dd>${posts.length}${list}</dd>
</dl>
<section class="unknown">
  <h2>What Acme does not know</h2>
  <ul>
    <li>Your name, email or any account.</li>
    <li>Your credential, its deposit, or how much of today's budget you have left.</li>
    <li>Which other sites you visit: each one sees a different pseudonym.</li>
  </ul>
</section>
<form method="post" action="/.fuse/logout"><button class="btn ghost" type="submit">Sign out</button></form>`,
  });
}

export function messagePage({ title, message }) {
  return layout({
    title: `${title} · Acme Forum`,
    body: `<h1 class="thread-title">${esc(title)}</h1><p>${esc(message)}</p><p><a class="btn" href="/">Back to the threads</a></p>`,
  });
}
