// Acme Forum: an ordinary Express app that knows nothing about Fuse except
// three request headers, fronted by the Fuse gateway in reverse-proxy mode.
//
//   browser ──▶ gateway :4710 (proofs, sessions, cache) ──▶ forum app 127.0.0.1:4711
//
// The app trusts X-Fuse-Pseudonym / -Short / -Reputation because only the
// gateway can reach it (it listens on loopback, and the gateway strips any
// X-Fuse-* headers clients send).
import { join } from 'node:path';
import express from 'express';
import { startProxyGateway } from '@fuse/gateway';
import { listen } from '../shared.js';
import { Board } from './board.js';
import { composePage, homePage, mePage, messagePage, threadPage } from './views.js';

export const FORUM_PROTECT = ['/new', '/posts', '/me'];

/** The forum application itself (what sits behind the gateway). */
export function createForumApp(board) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // Identity, as vouched for by the gateway. Absent on public pages.
  app.use((req, res, next) => {
    const pseudonym = req.get('x-fuse-pseudonym');
    req.member = pseudonym
      ? { pseudonym, short: req.get('x-fuse-pseudonym-short'), reputation: req.get('x-fuse-reputation') ?? 'probation' }
      : null;
    if (req.member) board.noteMember(pseudonym, req.member.short);
    next();
  });

  const requireMember = (req, res, next) => {
    if (req.member) return next();
    res.status(401).send(messagePage({ title: 'Fuse pass needed', message: 'This page is only reachable through the Fuse gateway.' }));
  };

  app.get('/', (req, res) => {
    res.send(homePage({ threads: board.threads(), now: Date.now() }));
  });

  app.get('/t/:id', (req, res) => {
    const thread = board.thread(req.params.id);
    if (!thread) return res.status(404).send(messagePage({ title: 'No such thread', message: 'It may have been removed.' }));
    res.send(threadPage({ thread, now: Date.now() }));
  });

  app.get('/new', requireMember, (req, res) => {
    const thread = req.query.thread ? board.thread(req.query.thread) : null;
    res.send(composePage({ short: req.member.short, thread }));
  });

  app.post('/posts', requireMember, (req, res) => {
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const body = text(req.body?.body);
    const title = text(req.body?.title);
    const threadId = text(req.body?.thread);
    const thread = threadId ? board.thread(threadId) : null;
    const fail = (error) => res.status(400).send(composePage({ short: req.member.short, thread, error, values: { title, body } }));

    if (threadId && !thread) return fail('That thread no longer exists.');
    if (!thread && (title.length < 3 || title.length > 120)) return fail('Give the thread a title of 3 to 120 characters.');
    if (body.length < 1 || body.length > 5000) return fail('Write between 1 and 5,000 characters.');

    const author = req.member.short;
    const created = thread ? board.reply({ threadId: thread.id, author, body }) : board.startThread({ author, title, body });
    res.redirect(303, `/t/${created.thread.id}#p${created.post.id}`);
  });

  app.get('/me', requireMember, (req, res) => {
    const { pseudonym, short, reputation } = req.member;
    res.send(mePage({ pseudonym, short, reputation, member: board.member(pseudonym), posts: board.postsBy(short), now: Date.now() }));
  });

  app.use((req, res) => res.status(404).send(messagePage({ title: 'Not found', message: 'There is nothing at this address.' })));
  return app;
}

/**
 * Start Acme Forum: the app on 127.0.0.1:upstreamPort and the Fuse gateway
 * (reverse proxy) on host:port. The site answers on `origins` (default
 * http://forum.localhost:<port>: its own host name, so browsers keep its
 * cookies apart from other demo sites on this machine). Reputation and posts
 * persist in dataDir/forum when dataDir is given. `onEvent` receives gateway events.
 * @returns {Promise<{ url: string, port: number, upstreamUrl: string, gateway: object, close(): Promise<void> }>}
 *   url is origins[0]; port is where the gateway listens
 */
export async function startForum({
  port = 4710,
  upstreamPort = 4711,
  host = process.env.FUSE_BIND || '127.0.0.1',
  registryUrl = 'http://localhost:4701',
  logUrl = 'http://localhost:4702',
  registryHint,
  dataDir,
  installUrl,
  onEvent,
  origins,
} = {}) {
  const siteDir = dataDir ? join(dataDir, 'forum') : undefined;
  const board = new Board({ file: siteDir && join(siteDir, 'forum.json') });
  const upstream = await listen(createForumApp(board), upstreamPort, '127.0.0.1');
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  let proxy;
  try {
    proxy = await startProxyGateway({
      port,
      host,
      upstream: upstreamUrl,
      origins: origins?.length ? origins : (bound) => [`http://forum.localhost:${bound}`],
      siteName: 'Acme Forum',
      protect: FORUM_PROTECT,
      registries: [registryUrl],
      registryHint: registryHint ?? registryUrl,
      log: logUrl,
      dataDir: siteDir,
      installUrl,
      onEvent,
    });
  } catch (err) {
    await upstream.close();
    throw err;
  }
  return {
    url: proxy.url,
    port: proxy.port,
    upstreamUrl,
    gateway: proxy.gateway,
    async close() {
      await proxy.close();
      await upstream.close();
      board.flush();
    },
  };
}
