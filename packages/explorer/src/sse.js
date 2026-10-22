// Server-sent events: an incremental parser and a reconnecting fetch-based
// subscriber. Portable (Node and browsers): the explorer follows every
// component's /events stream with it, and the page follows the explorer's
// merged stream with the same code (served at /sse.js).

/**
 * Incremental text/event-stream parser (WHATWG HTML "event stream
 * interpretation"). push() takes arbitrary text chunks; onEvent receives
 * { type, data, id, retry } for each dispatched event.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let started = false;
  let data = [];
  let type = '';
  let lastId = null; // the spec keeps the last event id across events
  let retry;

  function processLine(line) {
    if (line === '') {
      if (data.length) onEvent({ type: type || 'message', data: data.join('\n'), id: lastId, retry });
      data = [];
      type = '';
      retry = undefined;
      return;
    }
    if (line[0] === ':') return; // comment, used for keepalives
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value;
    else if (field === 'id' && !value.includes('\0')) lastId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }

  return {
    push(chunk) {
      buffer += chunk;
      if (!started && buffer.length) {
        started = true;
        if (buffer[0] === '﻿') buffer = buffer.slice(1);
      }
      // A trailing \r may be the first half of \r\n, so it waits for the next chunk.
      const terminator = /\r\n|\r(?!$)|\n/g;
      let start = 0;
      let match;
      while ((match = terminator.exec(buffer))) {
        processLine(buffer.slice(start, match.index));
        start = match.index + match[0].length;
      }
      buffer = buffer.slice(start);
    },
  };
}

/** One SSE frame. `data` is a string (already JSON-encoded by the caller). */
export function formatSseFrame({ id, type, data }) {
  let frame = '';
  if (id !== undefined && id !== null) frame += `id: ${id}\n`;
  if (type) frame += `event: ${type}\n`;
  for (const line of String(data).split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;
  return frame + '\n';
}

/**
 * Follow an SSE endpoint with fetch, reconnecting with exponential backoff
 * (plus jitter) whenever the source is down or the stream ends. Sends
 * Last-Event-ID on reconnect. The delay resets once a connection delivers an
 * event, so a source that accepts and immediately drops connections still
 * backs off.
 *
 * onEvent({ type, data, id }) for each event. onStatus({ status: 'open' | 'closed', error? })
 * fires on transitions only, not on every failed retry. Returns { close() }.
 */
export function subscribeSse(url, { onEvent, onStatus, minDelay = 500, maxDelay = 15_000, headers = {} } = {}) {
  const controller = new AbortController();
  let closed = false;
  let delay = minDelay;
  let lastEventId = null;
  let timer = null;
  let reported = null;

  const setStatus = (status, error) => {
    if (closed || status === reported) return;
    reported = status;
    onStatus?.(error === undefined ? { status } : { status, error });
  };

  async function connect() {
    timer = null;
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'text/event-stream',
          ...(lastEventId !== null ? { 'last-event-id': lastEventId } : {}),
          ...headers,
        },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      setStatus('open');
      const parser = createSseParser((event) => {
        delay = minDelay;
        if (event.id !== null) lastEventId = event.id;
        if (event.retry !== undefined) delay = Math.max(minDelay, Math.min(maxDelay, event.retry));
        if (closed) return;
        try {
          onEvent?.(event);
        } catch (err) {
          // A consumer bug must not look like a dropped connection.
          console.error('sse: event handler failed', err);
        }
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      throw new Error('stream ended');
    } catch (err) {
      if (closed) return;
      setStatus('closed', describeError(err));
      const wait = delay * (0.8 + Math.random() * 0.4);
      delay = Math.min(maxDelay, delay * 2);
      timer = setTimeout(connect, wait);
    }
  }

  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    },
  };
}

/** Short, human-readable reason for a failed fetch (e.g. "ECONNREFUSED", "HTTP 502"). */
export function describeError(err) {
  return err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
}
