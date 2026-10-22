// Display formatting shared by the popup and the in-page card.

/** "forum.localhost:4710" from "http://forum.localhost:4710". */
export function displayHost(originOrUrl) {
  try {
    return new URL(originOrUrl).host;
  } catch {
    return String(originOrUrl);
  }
}

/** 930 → "0.9 s", 12_400 → "12 s". */
export function seconds(ms) {
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** Local clock time, e.g. "7:00 AM" or "07:00" depending on locale. */
export function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Clock time today ("5:51 PM", or "5:51:37 PM" with seconds), date and time otherwise ("Oct 21, 5:51 PM"). */
export function eventTime(iso, { seconds = false, now = Date.now() } = {}) {
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Coarse duration until/since, e.g. "13 h 20 min", "4 min", "less than a minute". */
export function duration(ms) {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "resets at 07:00 (in 13 h 20 min)". */
export function resetText(resetsAt, now = Date.now()) {
  return `resets at ${clockTime(resetsAt)} (in ${duration(Date.parse(resetsAt) - now)})`;
}

/** "0x1a2b…c3d4" */
export function shortHex(hex, keep = 4) {
  if (typeof hex !== 'string' || hex.length <= 2 + keep * 2) return hex ?? '';
  return `${hex.slice(0, 2 + keep)}…${hex.slice(-keep)}`;
}

export function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}
