// The explorer's upstream sources: the registry, the shared log and each
// site's gateway. Their SSE streams are merged into one, every event tagged
// with `source`. Any source may be down; subscriptions retry with backoff.
import { describeError, subscribeSse } from './sse.js';

export async function getJson(url, { timeoutMs = 3000 } = {}) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

/**
 * Subscribe to each source's event stream ([{ id, url }]) and hand every
 * event to publish(), plus a `source-status` event whenever a source connects
 * or drops. Returns { status(), close() }.
 */
export function followSources(sources, { publish, reconnect = {} }) {
  const status = {};
  const subscriptions = sources.map(({ id, url }) => {
    status[id] = { status: 'connecting', since: now() };
    return subscribeSse(url, {
      ...reconnect,
      onStatus: ({ status: next, error }) => {
        status[id] = { status: next, since: now(), ...(error ? { error } : {}) };
        publish({ type: 'source-status', at: now(), source: id, status: next, ...(error ? { error } : {}) });
      },
      onEvent: (event) => publish(tagEvent(id, event)),
    });
  });
  return {
    status: () => structuredClone(status),
    close: () => subscriptions.forEach((s) => s.close()),
  };
}

/**
 * Upstream events are `event: <type>` + JSON `data` with `type` and `at`
 * (protocol §10). Keep the payload, make sure type and at are present, and
 * record which source sent it.
 */
export function tagEvent(source, { type, data }) {
  let body;
  try {
    body = JSON.parse(data);
  } catch {
    body = { raw: data };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) body = { value: body };
  const eventType = type && type !== 'message' ? type : (body.type ?? 'message');
  return { ...body, type: eventType, at: body.at ?? now(), source };
}

export { describeError };

const now = () => new Date().toISOString();
