// Fan-out of the explorer's merged event stream to browser clients, with a
// short replay buffer so a page that reconnects with Last-Event-ID misses
// nothing.
import { formatSseFrame } from './sse.js';

const KEEPALIVE_MS = 15_000;

export function createHub({ replay = 500 } = {}) {
  const clients = new Set();
  const recent = [];
  let nextId = 1;

  const keepalive = setInterval(() => {
    for (const res of clients) res.write(': keepalive\n\n');
  }, KEEPALIVE_MS);
  keepalive.unref();

  return {
    /** Send an event ({ type, at, source, ... }) to every client; returns its id. */
    publish(event) {
      const id = nextId++;
      const frame = formatSseFrame({ id, type: event.type, data: JSON.stringify(event) });
      recent.push({ id, frame });
      if (recent.length > replay) recent.shift();
      for (const res of clients) res.write(frame);
      return id;
    },

    /** Serve one SSE client: hello first, then anything missed since Last-Event-ID, then live events. */
    attach(req, res, hello) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });
      res.write(formatSseFrame({ type: 'hello', data: JSON.stringify(hello) }));
      const lastId = Number(req.headers['last-event-id']);
      if (Number.isInteger(lastId) && lastId > 0) {
        for (const { id, frame } of recent) if (id > lastId) res.write(frame);
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },

    get clientCount() {
      return clients.size;
    },

    close() {
      clearInterval(keepalive);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
