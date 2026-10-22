// Small HTTP and SSE clients for the log tests.

/** JSON client for a server base URL. Each call resolves { status, body, headers }. */
export function client(base) {
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
    raw: (path, init) => fetch(base + path, init),
  };
}

/** Subscribe to an SSE endpoint; next(type) resolves with the next event of that type. */
export function events(url) {
  const controller = new AbortController();
  const received = [];
  let wake = () => {};
  const headers = fetch(url, { signal: controller.signal }).then(async (res) => {
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const type = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (type && data) received.push({ type, data: JSON.parse(data) });
            wake();
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') throw err;
      }
    })().catch(() => {});
    return res.headers;
  });

  async function next(type, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = received.findIndex((e) => e.type === type);
      if (i >= 0) return received.splice(i, 1)[0].data;
      if (Date.now() > deadline) throw new Error(`timed out waiting for a ${type} event`);
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
    }
  }
  return { headers, next, close: () => controller.abort() };
}
