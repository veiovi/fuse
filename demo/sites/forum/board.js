// Acme Forum's data: threads, posts and what the forum itself has recorded
// about each pseudonym (first seen, posts). Optionally persisted as JSON.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR = 3600 * 1000;

/** Seed threads, timestamped relative to `now` so the board looks lived-in. */
function seed(now) {
  const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const threads = [
    {
      title: 'Welcome to Acme Forum: posting without an account',
      posts: [
        ['anon-a7c3e001', 71, 'Reading here is open to everyone. Posting asks for a Fuse pass instead of an account: your browser (or your agent) proves it holds a deposit-backed credential with budget left today, and we get a pseudonym that only exists on this forum.\n\nNo email, no password, nothing to leak. Be kind, and a ban will stick to your pseudonym.'],
        ['anon-5e1f02aa', 70, 'So if I get banned I just... come back with a new account? Asking for a friend.'],
        ['anon-a7c3e001', 69, 'You come back with the same pseudonym, because it comes from your credential. Getting a new one means a new deposit. That is the whole point.'],
      ],
    },
    {
      title: 'Sourdough starter smells like nail polish. Normal?',
      posts: [
        ['anon-5e1f02aa', 30, 'Day six of my starter and it smells sharply of acetone. It doubled yesterday but today it is sluggish. Bin it?'],
        ['anon-9c33d710', 28, "Don't bin it! Acetone smell means it's hungry. Feed it twice a day at 1:1:1 for a few days and keep it somewhere warm."],
        ['anon-41b8e2c5', 26, 'Seconding this. Mine did the same in week one. A spoon of rye flour perked it right up.'],
        ['anon-5e1f02aa', 9, 'Update: two feeds a day and it smells like yoghurt now. Baked my first loaf this morning!'],
      ],
    },
    {
      title: 'Weekend ride around the reservoir (42 km, mostly flat)',
      posts: [
        ['anon-41b8e2c5', 20, 'Planning an easy loop around the reservoir on Saturday, leaving the north car park at 9:00. Coffee stop at the boathouse. All paces welcome.'],
        ['anon-d0e7aa19', 14, "I'm in. Is the gravel section on the east side rideable on road tyres after the rain?"],
        ['anon-41b8e2c5', 13, '28 mm tyres are fine, it was packed hard last weekend.'],
      ],
    },
    {
      title: 'Is it weird that this forum does not know who I am?',
      posts: [
        ['anon-d0e7aa19', 5, 'I checked my /me page and it really is just a random-looking number, a reputation and when I first showed up. Other sites I use get a completely different number, apparently.'],
        ['anon-9c33d710', 3, 'Not weird, refreshing. The forum can still ban spammers, which is all I wanted from accounts anyway.'],
      ],
    },
  ];
  let postId = 1;
  const seeded = threads.map((thread, i) => ({
    id: i + 1,
    title: thread.title,
    posts: thread.posts.map(([author, hoursAgo, body]) => ({ id: postId++, author, body, createdAt: at(hoursAgo) })),
  }));
  return { threads: seeded, members: {}, nextPostId: postId };
}

export class Board {
  /** @param {{ file?: string, now?: () => number }} [options] */
  constructor({ file, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.data = this.#load() ?? seed(now());
    this.saveTimer = null;
  }

  #load() {
    if (!this.file) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  #changed() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 100);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** Threads, most recently active first. */
  threads() {
    const last = (t) => Date.parse(t.posts.at(-1).createdAt);
    return [...this.data.threads].sort((a, b) => last(b) - last(a));
  }

  thread(id) {
    return this.data.threads.find((t) => t.id === Number(id));
  }

  /** Remember a pseudonym the first time the gateway vouches for it. */
  noteMember(pseudonym, short) {
    if (this.data.members[pseudonym]) return this.data.members[pseudonym];
    const member = { short, firstSeen: new Date(this.now()).toISOString() };
    this.data.members[pseudonym] = member;
    this.#changed();
    return member;
  }

  member(pseudonym) {
    return this.data.members[pseudonym];
  }

  postsBy(short) {
    return this.data.threads.flatMap((thread) => thread.posts.filter((p) => p.author === short).map((post) => ({ thread, post })));
  }

  #post(author, body) {
    return { id: this.data.nextPostId++, author, body, createdAt: new Date(this.now()).toISOString() };
  }

  startThread({ author, title, body }) {
    const thread = { id: Math.max(0, ...this.data.threads.map((t) => t.id)) + 1, title, posts: [this.#post(author, body)] };
    this.data.threads.push(thread);
    this.#changed();
    return { thread, post: thread.posts[0] };
  }

  reply({ threadId, author, body }) {
    const thread = this.thread(threadId);
    if (!thread) return null;
    const post = this.#post(author, body);
    thread.posts.push(post);
    this.#changed();
    return { thread, post };
  }
}
