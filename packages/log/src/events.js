// Server-sent events (protocol §10): `event: <type>` + `data: <JSON>` where the
// JSON always carries `type` and `at`; each stream opens with a `hello` snapshot.

const PING_MS = 15_000;

/** A subscriber with more than this many bytes still unsent has stopped reading. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

export class EventHub {
  #clients = new Set();
  #timer;

  /**
   * @param {object} options
   * @param {() => object} options.snapshot state sent in each new stream's `hello` event
   * @param {number} [options.pingMs] interval of keep-alive comment lines
   * @param {number} [options.maxBufferedBytes] unsent bytes after which a subscriber is dropped
   */
  constructor({ snapshot, pingMs = PING_MS, maxBufferedBytes = MAX_BUFFERED_BYTES }) {
    this.snapshot = snapshot;
    this.maxBufferedBytes = maxBufferedBytes;
    this.#timer = setInterval(() => this.#broadcast(': ping\n\n'), pingMs);
    this.#timer.unref();
  }

  /** Express/Node handler for GET /events. */
  handler = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.write('retry: 3000\n\n');
    this.#clients.add(res);
    res.on('close', () => this.#clients.delete(res));
    res.write(frame('hello', this.snapshot()));
  };

  /** Send an event to every connected stream. */
  publish(type, data = {}) {
    this.#broadcast(frame(type, data));
  }

  get size() {
    return this.#clients.size;
  }

  /** End every stream and stop pinging. */
  close() {
    clearInterval(this.#timer);
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }

  #broadcast(chunk) {
    for (const res of this.#clients) {
      res.write(chunk);
      // Writes never wait, so a subscriber that stopped reading would have
      // every later event queued for it in memory. Cut it off instead.
      if (res.writableLength > this.maxBufferedBytes) {
        this.#clients.delete(res);
        res.destroy();
      }
    }
  }
}

function frame(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString(), ...data })}\n\n`;
}
