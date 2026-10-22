// Gateway events: fanned out to Server-Sent Events subscribers
// (GET /.fuse/events) and to an optional onEvent callback. Every event is
// { type, at, ...data }; each stream opens with a `hello` snapshot and gets a
// comment ping every 15 s so idle proxies keep it open.
//
// Streams are unauthenticated (demo), so they must not let a client make the
// gateway buffer without bound: string fields are capped (paths and names come
// from requests), and a subscriber that stops reading is dropped once 1 MB
// is queued for it.

const PING_MS = 15000;
const RECENT_LIMIT = 50;
const MAX_STRING = 256;
export const MAX_QUEUED_BYTES = 1024 * 1024;
/** High-volume events left out of the `recent` history replayed in `hello`. */
const NOT_RECENT = new Set(['cache']);

export class EventHub {
  /**
   * @param {object} options
   * @param {() => object} options.snapshot data for the `hello` event
   * @param {(event: object) => void} [options.onEvent]
   * @param {number} [options.pingMs]
   */
  constructor({ snapshot, onEvent, pingMs = PING_MS }) {
    this.snapshot = snapshot;
    this.onEvent = onEvent;
    this.clients = new Set();
    this.recent = [];
    this.pingTimer = setInterval(() => this.#write(': ping\n\n'), pingMs);
    this.pingTimer.unref?.();
  }

  /** Publish an event; returns it. */
  emit(type, data = {}) {
    const event = { type, at: new Date().toISOString() };
    for (const [key, value] of Object.entries(data)) event[key] = typeof value === 'string' ? cap(value) : value;
    if (!NOT_RECENT.has(type)) {
      this.recent.push(event);
      if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    }
    this.#write(format(event));
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // A faulty observer must not break request handling.
      }
    }
    return event;
  }

  /** Turn an HTTP response into an SSE stream. */
  attach(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    res.write(format({ type: 'hello', at: new Date().toISOString(), ...this.snapshot(), recent: this.recent }));
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  /** Stop serving a subscriber that is not keeping up. */
  #drop(res) {
    this.clients.delete(res);
    res.destroy();
  }

  close() {
    clearInterval(this.pingTimer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  #write(chunk) {
    for (const res of this.clients) {
      try {
        res.write(chunk);
        if (res.writableLength > MAX_QUEUED_BYTES) this.#drop(res);
      } catch {
        this.#drop(res);
      }
    }
  }
}

function cap(value) {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
}

function format(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
