// Formatting helpers for the explorer page. Pure functions, no DOM.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** 0x2c4f…a91c: enough of a 254-bit value to tell values apart at a glance. */
export function shortHex(value, head = 4, tail = 4) {
  if (typeof value !== 'string' || !value) return '';
  const prefix = value.startsWith('0x') ? '0x' : '';
  const body = value.slice(prefix.length);
  return body.length <= head + tail + 1 ? value : `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** Same short form as @fuse/core shortPseudonym. */
export function shortPseudonym(pseudonym) {
  return typeof pseudonym === 'string' && pseudonym.length >= 8 ? `anon-${pseudonym.slice(-8)}` : 'anon-?';
}

const numberFormat = new Intl.NumberFormat('en');
export const count = (n) => (Number.isFinite(n) ? numberFormat.format(n) : '–');

export const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

export function clock(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB', { hour12: false });
}

/** "6 h 12 min" until a timestamp (ms). */
export function until(ms, now = Date.now()) {
  const minutes = Math.max(0, Math.round((ms - now) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function seconds(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** host:port of a URL, for compact links. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url ?? '';
  }
}

/** Only http(s) URLs become links. */
export function safeUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** 16 bits from the low end of a hex value (low bits of field elements are uniform). */
export function lowBits(hex, bits = 16) {
  try {
    return Number(BigInt(hex) & ((1n << BigInt(bits)) - 1n));
  } catch {
    return 0;
  }
}

const REASONS = {
  'bad-proof': 'the proof did not verify',
  'wrong-epoch': 'it was made for another day',
  'unknown-root': 'its registry root is unknown',
  'malformed-token': 'the token was malformed',
  'malformed-authorization': 'the header was malformed',
  'missing-authorization': 'it carried no proof',
  'challenge-expired': 'the challenge had expired',
  'challenge-used': 'the challenge was already used',
  'challenge-invalid': 'the challenge was not ours',
  'origin-mismatch': 'it was made for another site',
  'origin-not-allowed': 'it was made for another site',
  'origin-invalid': 'its origin was malformed',
  'log-unavailable': 'the shared log did not answer',
  'registry-unavailable': 'the registry did not answer',
};

const reasonText = (reason) => REASONS[reason] ?? String(reason ?? 'unknown reason').replaceAll('-', ' ');

const who = (event) => event.short ?? (event.pseudonym ? shortPseudonym(event.pseudonym) : 'someone');

function where(event) {
  if (!event.path) return '';
  return ` ${event.method && event.method !== 'GET' ? `${event.method} ` : ''}${event.path}`;
}

/** One plain sentence for a gateway event (payloads as emitted by @fuse/gateway). */
export function describeEvent(event) {
  const name = who(event);
  switch (event.type) {
    case 'challenge-issued':
      return `Asked for a proof on${where(event) || ' a protected page'}`;
    case 'proof-accepted':
      return `Accepted a proof from ${name}`;
    case 'proof-rejected':
      if (event.reason === 'double-spend') return `Caught ${name} reusing a slot`;
      if (event.reason === 'replay') return 'Turned down a replayed proof';
      return `Turned down a proof: ${reasonText(event.reason)}`;
    case 'banned-request':
      return `Turned away banned ${name}`;
    case 'pseudonym-banned':
      if (event.by === 'double-spend') return `Banned ${name} for reusing a slot`;
      return `${event.by === 'moderator' ? 'A moderator banned' : 'Banned'} ${name}${event.reason ? ` (${event.reason})` : ''}`;
    case 'pseudonym-unbanned':
      return `Lifted the ban on ${name}`;
    case 'revocation-applied':
      return event.known === false
        ? `Banned ${name} in advance: its key burned elsewhere`
        : `Banned ${name}: its key burned`;
    case 'rate-limited':
      return `Slowed down ${name}${event.reputation ? `, still on ${event.reputation}` : ''}`;
    case 'spec-rejected':
      return `Refused a request outside the API spec${where(event) ? `:${where(event)}` : ''}`;
    case 'cache':
      return cacheHit(event) ? `Served${where(event) || ' a public page'} from cache` : `Cached${where(event) || ' a public page'}`;
    default:
      return String(event.type).replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

/** Events that repeat what another event already says (a revocation's ban is reported once). */
export const isRedundantEvent = (event) => event.type === 'pseudonym-banned' && event.by === 'revocation';

export const cacheHit = (event) => event.status === 'HIT' || event.hit === true;

/** Gateway events about burned keys and bans: shown in the alarm colour. */
export const isAlarmEvent = (event) =>
  ['banned-request', 'pseudonym-banned', 'revocation-applied'].includes(event.type) ||
  (event.type === 'proof-rejected' && event.reason === 'double-spend');
